import 'dotenv/config';
import express, { type Request, type Response } from 'express';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { GoogleGenAI } from '@google/genai';

const PORT = Number(process.env.PORT) || 3000;
function resolvePythonBackendUrl(): string {
  const raw = (process.env.PYTHON_BACKEND_URL || '').trim().replace(/\/+$/, '');
  if (raw && /^https?:\/\//i.test(raw)) {
    try {
      const parsed = new URL(raw);
      const h = parsed.hostname.toLowerCase();
      if (h === 'localhost' || h === '127.0.0.1' || h.includes('.')) {
        return raw;
      }
    } catch {
      // Fall through to local FastAPI default
    }
  }
  return 'http://127.0.0.1:8001';
}

const PYTHON_BACKEND_URL = resolvePythonBackendUrl();

type BootstrapState = 'idle' | 'bootstrapping' | 'starting' | 'ready';
let pythonBootstrapState: BootstrapState = 'idle';
let lastBootstrapAttemptMs = 0;

function ensureLocalPythonBackend(): void {
  if (!PYTHON_BACKEND_URL.startsWith('http://127.0.0.1:8001')) return;

  const probe = http.get('http://127.0.0.1:8001/api/health', { timeout: 1500 }, (res) => {
    res.resume();
    if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
      pythonBootstrapState = 'ready';
    }
  });

  probe.on('error', () => {
    const now = Date.now();
    if (
      (pythonBootstrapState === 'bootstrapping' || pythonBootstrapState === 'starting') &&
      now - lastBootstrapAttemptMs < 120_000
    ) {
      return;
    }
    lastBootstrapAttemptMs = now;

    const uvicornBin = path.resolve(process.cwd(), '.venv', 'bin', 'uvicorn');
    const bootstrapScript = path.resolve(process.cwd(), 'backend', 'bootstrap_python.sh');

    if (fs.existsSync(uvicornBin)) {
      pythonBootstrapState = 'starting';
      try {
        const child = spawn(
          uvicornBin,
          ['backend.main:app', '--host', '127.0.0.1', '--port', '8001'],
          {
            cwd: process.cwd(),
            env: { ...process.env, PYTHONPATH: process.cwd() },
            detached: true,
            stdio: 'ignore',
          }
        );
        child.on('exit', () => {
          pythonBootstrapState = 'idle';
        });
        child.unref();
        console.log('Auto-started local Python FastAPI backend on http://127.0.0.1:8001');
      } catch (err) {
        pythonBootstrapState = 'idle';
        console.error('Could not auto-start local Python backend:', err);
      }
      return;
    }

    if (fs.existsSync(bootstrapScript)) {
      pythonBootstrapState = 'bootstrapping';
      try {
        const child = spawn('/bin/bash', [bootstrapScript], {
          cwd: process.cwd(),
          env: { ...process.env, PYTHONPATH: process.cwd() },
          detached: true,
          stdio: 'ignore',
        });
        child.on('exit', () => {
          pythonBootstrapState = 'idle';
        });
        child.unref();
        console.log('Bootstrapping local Python FastAPI environment via backend/bootstrap_python.sh');
      } catch (err) {
        pythonBootstrapState = 'idle';
        console.error('Could not launch Python bootstrap script:', err);
      }
    }
  });

  probe.on('timeout', () => {
    probe.destroy();
  });
}

const OUTPUTS_DIR = path.resolve(process.cwd(), 'outputs');
const UPLOADS_DIR = path.resolve(process.cwd(), 'uploads');
fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const BACKEND_UNAVAILABLE_MSG =
  'Video processing backend is currently unavailable. Please ensure the Python FastAPI service is running and retry.';

const BACKEND_WARMING_MSG =
  'Video processing backend is warming up after server sleep. Please retry in a few seconds.';

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey || /^MY_GEMINI_API_KEY$/i.test(apiKey)) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function sendBackendUnavailable(res: Response, err?: unknown): void {
  ensureLocalPythonBackend();
  if (res.headersSent) return;
  const reason = err instanceof Error ? err.message : undefined;
  const isWarming = pythonBootstrapState === 'bootstrapping' || pythonBootstrapState === 'starting';
  const message = isWarming ? BACKEND_WARMING_MSG : BACKEND_UNAVAILABLE_MSG;
  res.status(503).json({
    error: message,
    detail: message,
    bootstrapping: isWarming,
    backendUrl: PYTHON_BACKEND_URL,
    reason,
  });
}

/**
 * Streams any incoming HTTP request (JSON, multipart upload, binary download, etc.)
 * directly to the Python FastAPI backend without buffering or mutating payloads.
 */
function proxyToPython(req: Request, res: Response, targetPath?: string): void {
  const upstreamPath = targetPath ?? req.originalUrl;
  let targetUrl: URL;
  try {
    targetUrl = new URL(upstreamPath, `${PYTHON_BACKEND_URL}/`);
  } catch (err) {
    sendBackendUnavailable(res, err);
    return;
  }

  const transport = targetUrl.protocol === 'https:' ? https : http;
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers.host = targetUrl.host;
  delete headers['content-length'];
  if (req.headers['content-length']) {
    headers['content-length'] = req.headers['content-length'];
  }

  const upstreamReq = transport.request(
    {
      protocol: targetUrl.protocol,
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: `${targetUrl.pathname}${targetUrl.search}`,
      headers,
      timeout: 300_000,
    },
    (upstreamRes) => {
      const statusCode = upstreamRes.statusCode || 502;
      const responseHeaders: http.OutgoingHttpHeaders = { ...upstreamRes.headers };
      delete responseHeaders['transfer-encoding'];
      res.writeHead(statusCode, responseHeaders);
      upstreamRes.pipe(res);
    }
  );

  upstreamReq.on('timeout', () => {
    upstreamReq.destroy(new Error('Upstream Python backend request timed out.'));
  });

  upstreamReq.on('error', (err) => {
    sendBackendUnavailable(res, err);
  });

  req.on('aborted', () => {
    upstreamReq.destroy();
  });

  req.pipe(upstreamReq);
}

function streamLocalMediaFile(req: Request, res: Response, filePath: string): void {
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const ext = path.extname(filePath).toLowerCase();
  const contentType =
    ext === '.jpg' || ext === '.jpeg'
      ? 'image/jpeg'
      : ext === '.png'
        ? 'image/png'
        : ext === '.webm'
          ? 'video/webm'
          : ext === '.mov'
            ? 'video/quicktime'
            : ext === '.mp4'
              ? 'video/mp4'
              : 'application/octet-stream';

  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = Math.max(0, parseInt(parts[0], 10) || 0);
    const end = parts[1] ? Math.min(fileSize - 1, parseInt(parts[1], 10)) : fileSize - 1;
    if (start > end || start >= fileSize) {
      res.status(416).setHeader('Content-Range', `bytes */${fileSize}`).end();
      return;
    }
    const chunkSize = end - start + 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': contentType,
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
    return;
  }

  res.writeHead(200, {
    'Content-Length': fileSize,
    'Accept-Ranges': 'bytes',
    'Content-Type': contentType,
  });
  fs.createReadStream(filePath).pipe(res);
}

async function startServer() {
  const app = express();

  // Lightweight support chat route (JSON parsed only on this route so proxy routes stay raw streams)
  app.post('/api/support/chat', express.json({ limit: '1mb' }), async (req: Request, res: Response) => {
    const question = String((req.body as { question?: string })?.question || '').trim();
    if (!question) {
      res.status(400).json({ error: 'Question is required.' });
      return;
    }

    const ai = getGeminiClient();
    if (ai) {
      try {
        const model = (process.env.GEMINI_MODEL || 'gemini-4-hydrogen').trim();
        const resp = await ai.models.generateContent({
          model,
          contents: [
            'You are Scalereach Support inside the Scalereach AI video-clipping app.',
            'Help users concisely in 1-2 short friendly sentences.',
            'Supported inputs: direct MP4/MOV/WebM/MKV uploads and public video URLs (YouTube, Vimeo, Twitch, Drive, Dropbox, direct links).',
            'Users can configure clip duration, aspect ratio (9:16, 1:1, 16:9), smart reframing, split-screen backgrounds, caption styles, and language.',
            `User question: ${question}`,
          ].join('\n'),
        });
        const reply = (resp.text || '').trim();
        if (reply) {
          res.json({ reply });
          return;
        }
      } catch {
        // Fall back to static help text
      }
    }

    res.json({
      reply:
        'Upload an MP4/MOV/WebM file or paste a video link you own rights to, pick your clip duration and style, and click "Get Clips".',
    });
  });

  // Health endpoint checks the Python backend directly
  app.get('/api/health', (req: Request, res: Response) => {
    proxyToPython(req, res, '/api/health');
  });

  // All video, clip, job, transcript, upload, workspace API-key & webhook routes proxy exclusively to Python FastAPI.
  // NO Node video processing fallback, NO fake clips, NO fake scores.
  app.all('/api/*', (req: Request, res: Response) => {
    proxyToPython(req, res);
  });

  // Serve rendered outputs directly from shared disk when present, otherwise proxy to Python backend
  app.get('/outputs/:jobId/:filename', (req: Request, res: Response) => {
    const jobId = String(req.params.jobId || '').replace(/[^a-zA-Z0-9_-]/g, '');
    const filename = path.basename(String(req.params.filename || ''));
    const filePath = path.join(OUTPUTS_DIR, jobId, filename);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      streamLocalMediaFile(req, res, filePath);
      return;
    }
    proxyToPython(req, res, `/outputs/${encodeURIComponent(jobId)}/${encodeURIComponent(filename)}`);
  });

  // Serve uploaded videos/thumbnails directly from shared disk when present, otherwise proxy to Python backend
  app.get('/uploads/:filename', (req: Request, res: Response) => {
    const filename = path.basename(String(req.params.filename || ''));
    const filePath = path.join(UPLOADS_DIR, filename);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      streamLocalMediaFile(req, res, filePath);
      return;
    }
    proxyToPython(req, res, `/uploads/${encodeURIComponent(filename)}`);
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req: Request, res: Response) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  ensureLocalPythonBackend();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(
      `Scalereach proxy/UI server running on http://0.0.0.0:${PORT} -> Python backend ${PYTHON_BACKEND_URL}`
    );
  });
}

void startServer();
