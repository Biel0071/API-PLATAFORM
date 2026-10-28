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

  console.log('Current accounts count:', accounts.length);
  for (const acc of accounts) {
    if (acc.providerName !== 'ollama') {
      console.log(`Disconnecting mock/dummy account: ${acc.id} (${acc.providerName})`);
      const delRes = await fetch(`http://209.50.241.22:3001/admin/provider-accounts/${acc.id}`, {
        method: 'DELETE',
        headers
      });
      console.log(`Status: ${delRes.status}`);
    } else {
      console.log(`Keeping real verified active account: ${acc.id} (${acc.providerName} - ${acc.displayName})`);
    }
  }

  const verifyRes = await fetch('http://209.50.241.22:3001/admin/provider-accounts', { headers });
  const verifyData = await verifyRes.json();
  console.log('Remaining accounts in DB:');
  console.log(JSON.stringify(verifyData.accounts, null, 2));
})();
