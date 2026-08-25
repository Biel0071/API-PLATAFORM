import axios from 'axios';

async function testAPILayer() {
  console.log('Testing APILayer Integration (Weather)...');
  
  try {
    const response = await axios.post('http://localhost:3000/v1/chat/completions', {
      model: 'openai/gpt-4o-mini', // or any model mapped to support tools
      messages: [
        { role: 'user', content: 'Qual é o clima atual em Londres e a taxa de câmbio de USD para EUR?' }
      ]
    }, {
      headers: {
        'Authorization': 'Bearer test-token',
        'Content-Type': 'application/json'
      }
    });

    console.log('\n--- RESPONSE ---');
    console.log(response.data.choices[0].message.content);
    console.log('\n--- GATEWAY TRACE ---');
    console.log(JSON.stringify(response.data._gateway, null, 2));

  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
  }
}

testAPILayer();
