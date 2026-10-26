const apiKey = 'rnd_TYXkNgNIAqGZH2SeJLnll09A7roP';
const serviceId = 'srv-dbe718bncjis73d7slqg';

async function main() {
  const res = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys?limit=1`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json'
    }
  });

  const text = await res.json();
  console.log('Latest deploy:', text[0]?.deploy?.id, 'Status:', text[0]?.deploy?.status, 'Commit:', text[0]?.deploy?.commit?.message);
}

main().catch(console.error);
