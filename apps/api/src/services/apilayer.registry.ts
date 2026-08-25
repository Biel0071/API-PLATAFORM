import axios from 'axios';

const APILAYER_ACCESS_KEY = '873c973d4de2a83d10c95ba25855d895';

export const apiLayerTools = [
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

export class APILayerRegistry {
  static async executeTool(name: string, args: any): Promise<any> {
    try {
      if (name === 'get_current_weather') {
        const response = await axios.get(`http://api.weatherstack.com/current`, {
          params: {
            access_key: APILAYER_ACCESS_KEY,
            query: args.location
          }
        });
        return JSON.stringify(response.data);
      }
      
      if (name === 'get_exchange_rate') {
        const response = await axios.get(`http://api.exchangeratesapi.io/v1/latest`, {
          params: {
            access_key: APILAYER_ACCESS_KEY,
            base: args.base,
            symbols: args.symbols
          }
        });
        return JSON.stringify(response.data);
      }
      
      return JSON.stringify({ error: 'Tool not found in APILayer Registry' });
    } catch (error: any) {
      console.error('[APILAYER] Erro na tool', name, error?.response?.data || error.message);
      return JSON.stringify({ error: 'Failed to fetch from APILayer', details: error?.response?.data || error.message });
    }
  }
}
