import { z } from 'zod';
import { pedirJson } from './openrouter.js';
import { config } from '../config.js';
import type { Creator, Item } from '../db/types.js';

/**
 * Primeiro passo, barato: uma nota rápida para descartar o que é claramente
 * lixo antes de gastar o modelo caro.
 *
 * O que ela NÃO faz: resumo e gancho. Isso continua saindo do scorer completo,
 * então nada do que a criadora recebe perde qualidade — a triagem só decide
 * quem chega até lá.
 *
 * O corte da triagem é deliberadamente mais baixo que o corte de envio. Errar
 * para cima só custa uma chamada extra ao modelo caro; errar para baixo mata
 * uma novidade boa em silêncio, que é o único erro que o produto não tolera.
 */
const RespostaTriagem = z.object({
  score: z.number().describe('0 a 10: o quanto este item tem chance de virar vídeo para ESTA criadora'),
});

/** Bem menor que o do scorer: aqui só decidimos "vale olhar de perto?". */
const LIMITE_TEXTO = 1500;

const INSTRUCOES = `Você faz a TRIAGEM de novidades para uma criadora de conteúdo brasileira.

Sua única tarefa é dar uma nota de 0 a 10 estimando a chance de este item virar
vídeo para ESTA criadora. Não escreva resumo, gancho nem justificativa.

- 0-2: claramente fora do que ela cobre
- 3-5: tangencia, incerto
- 6-10: dentro do que ela cobre

Na dúvida, arredonde para CIMA. Um item descartado aqui nunca mais é avaliado,
e perder uma novidade boa custa mais caro que gastar uma avaliação a mais.

Devolva apenas {"score": N}.`;

export interface EntradaTriagem {
  creator: Pick<Creator, 'nome' | 'nicho' | 'perfil_texto'>;
  item: Pick<Item, 'titulo' | 'texto' | 'autor' | 'publicado_em' | 'url'>;
  nomeFonte: string;
}

/** Nota de triagem, 0 a 10. Lança `ErroModelo` como o scorer. */
export async function triar(entrada: EntradaTriagem): Promise<number> {
  const { creator, item, nomeFonte } = entrada;

  const perfil = [
    creator.nicho ? `Nicho: ${creator.nicho}` : null,
    'Perfil dela:',
    creator.perfil_texto.trim(),
  ]
    .filter((l) => l !== null)
    .join('\n');

  const conteudo = [
    `Fonte: ${nomeFonte}`,
    `Título: ${item.titulo}`,
    (item.texto ?? '').trim().slice(0, LIMITE_TEXTO),
  ]
    .filter((l) => l !== '')
    .join('\n');

  const saida = await pedirJson(
    {
      system: `${INSTRUCOES}\n\n---\n\n${perfil}`,
      user: conteudo,
      nome: 'triagem_item',
      modelo: config.openrouter.modeloTriagem,
      maxTokens: 200,
    },
    RespostaTriagem,
  );

  return Math.min(10, Math.max(0, Math.round(saida.score)));
}
