(async () => {
  const loginRes = await fetch('http://209.50.241.22:3001/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@aiplatform.local', password: 'admin123' })
  });
  const { token } = await loginRes.json();
  const headers = { Authorization: `Bearer ${token}` };

  const [healthRes, accountsRes, providersRes] = await Promise.all([
    fetch('http://209.50.241.22:3001/v1/health', { headers }),
    fetch('http://209.50.241.22:3001/admin/provider-accounts', { headers }),
    fetch('http://209.50.241.22:3001/admin/providers', { headers }),
  ]);

  const health = await healthRes.json();
  const accounts = await accountsRes.json();
  const providers = await providersRes.json();

  console.log('--- HEALTH PROVIDERS ---');
  console.log(JSON.stringify(health.providers, null, 2));

  console.log('--- ACCOUNTS IN DB ---');
  console.log(JSON.stringify(accounts, null, 2));

  console.log('--- PROVIDER SETTINGS ---');
  console.log(JSON.stringify(providers, null, 2));
})();
