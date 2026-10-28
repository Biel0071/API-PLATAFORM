(async () => {
  const loginRes = await fetch('http://209.50.241.22:3001/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@aiplatform.local', password: 'admin123' })
  });
  const { token } = await loginRes.json();
  const headers = { Authorization: `Bearer ${token}` };

  const accountsRes = await fetch('http://209.50.241.22:3001/admin/provider-accounts', { headers });
  const { accounts } = await accountsRes.json();
  console.log('Accounts in DB:', accounts.map(a => `${a.id}: ${a.providerName}`));

  const ollama = accounts.find(a => a.providerName === 'ollama');
  if (ollama) {
    console.log('Testing auto-identify on live Ollama account:', ollama.id);
    const autoRes = await fetch(`http://209.50.241.22:3001/admin/provider-accounts/${ollama.id}/auto-identify`, {
      method: 'POST',
      headers
    });
    console.log('Status:', autoRes.status);
    const data = await autoRes.json();
    console.log('Auto-identify Result:', JSON.stringify(data, null, 2));
  }
})();
