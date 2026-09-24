const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');
const ssh = ['-i', 'C:/Users/Dell/.ssh/grg_fenix_vps', '-o', 'BatchMode=yes', 'root@209.50.241.22'];
const remote = '/tmp/vps-dashboard-qa-user.cjs';
execFileSync('scp', ['-i', 'C:/Users/Dell/.ssh/grg_fenix_vps', path.join(__dirname, 'vps-dashboard-qa-user.cjs'), `root@209.50.241.22:${remote}`], { timeout: 30000 });
execFileSync('ssh', [...ssh, `docker cp ${remote} api-platform-api-1:/app/apps/api/qa-vps-dashboard-user.cjs`], { timeout: 30000 });
let credentials;
try {
  credentials = JSON.parse(execFileSync('ssh', [...ssh, 'docker exec api-platform-api-1 node /app/apps/api/qa-vps-dashboard-user.cjs create'], { encoding: 'utf8', timeout: 30000 }));
  if (!credentials.ADMIN_EMAIL || !credentials.ADMIN_PASSWORD) throw new Error('Não foi possível criar usuário QA');
  const result = spawnSync(process.execPath, ['qa/front-production-audit.cjs'], {
    env: { ...process.env, ...credentials, TEST_HOST: 'http://209.50.241.22:8081' },
    stdio: 'inherit', timeout: 25 * 60 * 1000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status || 0;
} finally {
  if (credentials?.ADMIN_EMAIL) execFileSync('ssh', [...ssh, `docker exec api-platform-api-1 node /app/apps/api/qa-vps-dashboard-user.cjs delete ${credentials.ADMIN_EMAIL}`], { encoding: 'utf8', timeout: 30000 });
  execFileSync('ssh', [...ssh, `docker exec api-platform-api-1 rm -f /app/apps/api/qa-vps-dashboard-user.cjs; rm -f ${remote}`], { timeout: 30000 });
}
