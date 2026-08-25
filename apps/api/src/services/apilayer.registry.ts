const APILAYER_ACCESS_KEY = process.env.APILAYER_ACCESS_KEY;

async function getJson(url: string, params: Record<string, string | undefined>): Promise<unknown> {
  const requestUrl = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) requestUrl.searchParams.set(key, value);
  }

  const response = await fetch(requestUrl);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof data === 'object' && data && 'error' in data ? JSON.stringify(data) : response.statusText;
    throw new Error(message);
  }
  return data;
}

const configuredApiLayerTools = [
  {
    type: 'function',
    function: {
      name: 'get_current_weather',
      description: 'Obtém o clima atual para uma cidade específica usando o Weatherstack (APILayer).',
      parameters: {
        type: 'object',
        properties: {
          location: {
            type: 'string',
            description: 'A cidade para buscar o clima, ex: "New York", "São Paulo".'
          }
        },
        required: ['location']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_exchange_rate',
      description: 'Obtém taxas de câmbio históricas ou atuais de moedas usando a APILayer.',
      parameters: {
        type: 'object',
        properties: {
          base: {
            type: 'string',
            description: 'A moeda base em formato de 3 letras, ex: USD, EUR, BRL.'
          },
          symbols: {
            type: 'string',
            description: 'As moedas de destino separadas por vírgula, ex: "BRL,EUR".'
          }
        },
        required: ['base', 'symbols']
      }
    }
  }
];

export const apiLayerTools = APILAYER_ACCESS_KEY ? configuredApiLayerTools : [];

export class APILayerRegistry {
  static async executeTool(name: string, args: any): Promise<any> {
    try {
      if (!APILAYER_ACCESS_KEY) {
        return JSON.stringify({ error: 'APILAYER_ACCESS_KEY is not configured' });
      }

      if (name === 'get_current_weather') {
        const data = await getJson('http://api.weatherstack.com/current', {
          access_key: APILAYER_ACCESS_KEY,
          query: args.location,
        });
        return JSON.stringify(data);
      }
      
      if (name === 'get_exchange_rate') {
        const data = await getJson('http://api.exchangeratesapi.io/v1/latest', {
          access_key: APILAYER_ACCESS_KEY,
          base: args.base,
          symbols: args.symbols,
        });
        return JSON.stringify(data);
      }
      
      return JSON.stringify({ error: 'Tool not found in APILayer Registry' });
    } catch (error: any) {
      console.error('[APILAYER] Erro na tool', name, error.message);
      return JSON.stringify({ error: 'Failed to fetch from APILayer', details: error.message });
    }
  }
}
