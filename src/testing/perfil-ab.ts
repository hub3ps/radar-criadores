/**
 * Compara dois `perfil_texto` pontuando os MESMOS itens com cada um.
 * Não grava nada: só mostra as notas lado a lado.
 *
 *   npx tsx src/testing/perfil-ab.ts
 */
import { pontuar } from '../core/scorer.js';
import { db } from '../db/supabase.js';
import type { Item } from '../db/types.js';

const ANTIGO =
  'Eu falo com mulheres marjoritariamemte, entre 18 a 45 anos que gostam de filmes, séries e livros de romance';

const NOVO = `Público e nicho: fala majoritariamente com mulheres de 18 a 45 anos que gostam de filmes, séries e livros de romance.

COBRE — o que a faz querer gravar:
Novidade sobre filme, série ou livro de ROMANCE: anúncio de adaptação de livro para as telas, trailer novo, data de estreia, escalação de elenco, e fofoca de bastidor do elenco desses títulos. Também vale casal do momento, química entre protagonistas e o que está bombando em romance no streaming.

NÃO COBRE — o critério é excludente, não uma lista:
Se o item não for sobre filme, série, livro, fofoca ou qualquer assunto ligado a ROMANCE, ela não grava — por mais relevante que seja para o público geral de cinema. Ficam de fora: terror, ação sem núcleo romântico, games, documentário, premiação técnica, notícia de mercado e bastidor de indústria (contratos, bilheteria, executivos, prêmios estrangeiros). Na dúvida, se o romance não é o centro do item, a nota é baixa.`;

const { data, error } = await db
  .from('items')
  .select('*, sources(nome)')
  .order('coletado_em', { ascending: false })
  .limit(12);

if (error) throw new Error(error.message);

type Linha = Item & { sources: { nome: string } | { nome: string }[] | null };
const itens = (data ?? []) as unknown as Linha[];

console.log(`\ncomparando ${itens.length} itens\n`);
console.log('ANTIGO  NOVO  Δ    fonte / título');
console.log('─'.repeat(96));

let somaAntigo = 0;
let somaNovo = 0;

for (const bruto of itens) {
  const { sources, ...item } = bruto;
  const fonte = (Array.isArray(sources) ? sources[0] : sources)?.nome ?? '?';

  const base = { nome: 'Morgana', nicho: 'Filmes, séries e livros de romance' };
  const [a, n] = await Promise.all([
    pontuar({ creator: { ...base, perfil_texto: ANTIGO }, item, nomeFonte: fonte }).catch(() => null),
    pontuar({ creator: { ...base, perfil_texto: NOVO }, item, nomeFonte: fonte }).catch(() => null),
  ]);

  if (!a || !n) {
    console.log(`  erro ao pontuar: ${item.titulo.slice(0, 60)}`);
    continue;
  }

  somaAntigo += a.score;
  somaNovo += n.score;
  const delta = n.score - a.score;
  const seta = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : ' 0';

  console.log(
    `  ${String(a.score).padStart(2)}     ${String(n.score).padStart(2)}   ${seta.padStart(3)}  ` +
      `${fonte.slice(0, 22).padEnd(22)} ${item.titulo.slice(0, 44)}`,
  );
}

console.log('─'.repeat(96));
console.log(`  média antigo: ${(somaAntigo / itens.length).toFixed(1)}   média novo: ${(somaNovo / itens.length).toFixed(1)}`);
console.log('\n(o que importa não é a média, e sim a SEPARAÇÃO entre o que ela grava e o que não)');
