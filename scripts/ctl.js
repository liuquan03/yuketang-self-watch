const fs = require('fs');
const http = require('http');
const path = require('path');

const command = process.argv[2] || 'status';
const routes = {
  status: ['GET', '/status'],
  presence: ['POST', '/presence'],
  play: ['POST', '/play'],
  pause: ['POST', '/pause'],
  next: ['POST', '/next'],
  homework: ['POST', '/homework'],
  study: ['POST', '/study'],
  stop: ['POST', '/stop'],
};

if (!routes[command]) {
  console.error('用法: node ctl.js status|presence|play|pause|next|homework|study|stop');
  process.exit(2);
}

const token = fs.readFileSync(path.join(__dirname, 'control-token'), 'utf8').trim();
const [method, requestPath] = routes[command];
const req = http.request(
  {
    hostname: '127.0.0.1',
    port: 7862,
    path: requestPath,
    method,
    headers: { 'X-Yuketang-Token': token },
    timeout: 5000,
  },
  (res) => {
    res.setEncoding('utf8');
    res.on('data', (chunk) => process.stdout.write(chunk));
    res.on('end', () => process.stdout.write('\n'));
  }
);
req.on('error', (err) => {
  console.error(err.message);
  process.exitCode = 1;
});
req.end();
