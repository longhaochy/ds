#!/usr/bin/env node
const { CommandLineOption, parseArgs, style } = require('node:util');
const { Pool, Agent } = require('undici');
const { performance } = require('node:perf_hooks');

const stats = { total: 0n, success: 0n, failed: 0n };

function buildPool(target) {
  const url = new URL(target);
  const isTLS = url.protocol === 'https:';
  return new Pool(url.origin, {
    connections: 10000,
    pipelining: 1,
    headersTimeout: 10000,
    bodyTimeout: 10000,
    connectTimeout: 10000,
    keepAliveTimeout: 30000,
    keepAliveMaxTimeout: 30000,
    ...(isTLS && {
      tls: {
        rejectUnauthorized: false,
        ALPNProtocols: ['h2', 'http/1.1'],
        ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
        minVersion: 'TLSv1.3',
        maxVersion: 'TLSv1.3',
      },
    }),
  });
}

const HEADERS = {
  'user-agent': '',
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
  'accept-encoding': 'gzip, deflate, br',
  'accept-language': 'en-US,en;q=0.9,id;q=0.8',
  'cache-control': 'max-age=0',
  'sec-ch-ua': '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
  dnt: '1',
};

async function makeRequest(pool, target) {
  try {
    const res = await pool.request({
      method: 'GET',
      path: new URL(target).pathname + new URL(target).search,
      headers: HEADERS,
    });
    await res.body.dump();
    return res.statusCode >= 200 && res.statusCode < 500;
  } catch {
    return false;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
  });

  if (positionals.length < 3) {
    console.log('Usage: kinda <url> <duration_seconds> <rate_per_second>');
    console.log('Example: kinda https://example.com 10 100');
    process.exit(1);
  }

  const target = positionals[0];
  const duration = Number(positionals[1]);
  const rate = Number(positionals[2]);

  if (!Number.isInteger(duration) || duration <= 0) {
    console.log('Error: duration must be a positive integer (seconds)');
    process.exit(1);
  }
  if (!Number.isInteger(rate) || rate <= 0) {
    console.log('Error: rate must be a positive integer (req/s)');
    process.exit(1);
  }

  const pool = buildPool(target);
  const intervalMs = 1000 / rate;
  const deadline = performance.now() + duration * 1000;
  const inflight = new Set();

  console.log(`Starting undici requests to ${target}`);
  console.log(`Duration: ${duration}s | Rate: ${rate} req/s\n`);

  const start = performance.now();

  await new Promise((resolve) => {
    const tick = () => {
      if (performance.now() >= deadline) {
        resolve();
        return;
      }
      stats.total += 1n;
      const p = makeRequest(pool, target).then((ok) => {
        if (ok) stats.success += 1n;
        else stats.failed += 1n;
      });
      inflight.add(p);
      p.finally(() => inflight.delete(p));
      setTimeout(tick, intervalMs);
    };
    tick();
  });

  await Promise.all(inflight);
  await pool.close();

  const elapsed = (performance.now() - start) / 1000;
  const total = Number(stats.total);

  console.log('========== SUMMARY ==========');
  console.log(`Target      : ${target}`);
  console.log(`Duration    : ${elapsed.toFixed(2)}s`);
  console.log(`Total Req   : ${total}`);
  console.log(`Success     : ${stats.success}`);
  console.log(`Failed      : ${stats.failed}`);
  console.log(`Avg Rate    : ${(total / elapsed).toFixed(2)} req/s`);
  console.log('=============================');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});