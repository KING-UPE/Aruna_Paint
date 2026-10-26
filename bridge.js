import net from 'node:net';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Ensure WSL Postgres service is active
try {
  execSync('wsl -u root systemctl start postgresql', { stdio: 'ignore' });
} catch (e) {
  // Ignored if already running
}

const availableWorkers = [];
const pendingClients = [];

function pair(client, worker) {
  client.setKeepAlive(true, 10000);
  worker.setKeepAlive(true, 10000);
  client.pipe(worker);
  worker.pipe(client);

  client.on('error', () => worker.destroy());
  worker.on('error', () => client.destroy());
  client.on('close', () => worker.destroy());
  worker.on('close', () => client.destroy());
}

// 1. Internal port for WSL workers to connect to
const workerServer = net.createServer((worker) => {
  worker.on('error', () => {
    const idx = availableWorkers.indexOf(worker);
    if (idx !== -1) availableWorkers.splice(idx, 1);
  });

  worker.on('close', () => {
    const idx = availableWorkers.indexOf(worker);
    if (idx !== -1) availableWorkers.splice(idx, 1);
  });

  if (pendingClients.length > 0) {
    const client = pendingClients.shift();
    pair(client, worker);
  } else {
    availableWorkers.push(worker);
  }
});

workerServer.listen(5433, '0.0.0.0', () => {
  console.log('Worker pool listening on 0.0.0.0:5433');
});

// 2. Port 54320 for Postgres clients (Prisma, backend Fastify)
const clientServer = net.createServer((client) => {
  if (availableWorkers.length > 0) {
    const worker = availableWorkers.shift();
    pair(client, worker);
  } else {
    pendingClients.push(client);
    client.on('close', () => {
      const idx = pendingClients.indexOf(client);
      if (idx !== -1) pendingClients.splice(idx, 1);
    });
  }
});

clientServer.listen(54320, '127.0.0.1', () => {
  console.log('PostgreSQL Bridge listening on 127.0.0.1:54320');
});

// 3. Auto-spawn worker in WSL
const workerPyPath = path.posix.join(
  __dirname.replace(/^[a-zA-Z]:/, (m) => `/mnt/${m[0].toLowerCase()}`).replace(/\\/g, '/'),
  'worker.py'
);

const workerProc = spawn('wsl', ['python3', workerPyPath], {
  stdio: ['ignore', 'inherit', 'inherit'],
  windowsHide: true,
});

process.on('exit', () => workerProc.kill());
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
