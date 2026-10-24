const apiKey = 'rnd_TYXkNgNIAqGZH2SeJLnll09A7roP';
const serviceId = 'srv-dbe718bncjis73d7slqg';

async function main() {
  const res = await fetch(`https://api.render.com/v1/services/${serviceId}/deploys?limit=5`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Accept': 'application/json'
    }
  });

  const text = await res.json();
  console.log('Deploys:', JSON.stringify(text, null, 2));
}

main().catch(console.error);
