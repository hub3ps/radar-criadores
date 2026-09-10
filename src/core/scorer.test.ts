import '../testing/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ErroScorer, extrairJson, interpretarResposta } from './scorer.js';

const valida = { score: 8, motivo: 'encaixa no nicho', resumo: 'duas linhas', gancho: 'a abertura' };

describe('extrairJson', () => {
  test('lê JSON limpo', () => {
    assert.deepEqual(extrairJson('{"a":1}'), { a: 1 });
  });

  test('lê JSON cercado por bloco markdown', () => {
    assert.deepEqual(extrairJson('```json\n{"a":1}\n```'), { a: 1 });
    assert.deepEqual(extrairJson('```\n{"a":1}\n```'), { a: 1 });
  });

  test('lê JSON com conversa em volta', () => {
    assert.deepEqual(extrairJson('Claro! Aqui está:\n{"a":1}\nEspero ter ajudado.'), { a: 1 });
  });

  test('devolve null quando não há objeto', () => {
    assert.equal(extrairJson('desculpe, não posso ajudar'), null);
    assert.equal(extrairJson(''), null);
    assert.equal(extrairJson('   '), null);
  });

  test('devolve null para JSON quebrado', () => {
    assert.equal(extrairJson('{"a":'), null);
  });
});

describe('interpretarResposta', () => {
  test('aceita a resposta bem formada', () => {
    assert.deepEqual(interpretarResposta(JSON.stringify(valida)), valida);
  });

  test('apara espaço em volta dos textos', () => {
    const saida = interpretarResposta(JSON.stringify({ ...valida, motivo: '  com espaço  ' }));
    assert.equal(saida.motivo, 'com espaço');
  });

  test('arredonda score fracionário', () => {
    assert.equal(interpretarResposta(JSON.stringify({ ...valida, score: 7.6 })).score, 8);
  });

  test('prende score fora da faixa 0-10', () => {
    assert.equal(interpretarResposta(JSON.stringify({ ...valida, score: 99 })).score, 10);
    assert.equal(interpretarResposta(JSON.stringify({ ...valida, score: -5 })).score, 0);
  });

  test('rejeita resposta sem as chaves obrigatórias', () => {
    assert.throws(() => interpretarResposta('{"score":8}'), ErroScorer);
  });

  test('rejeita score que não é número', () => {
    assert.throws(() => interpretarResposta(JSON.stringify({ ...valida, score: 'oito' })), ErroScorer);
  });

  test('rejeita texto sem JSON nenhum', () => {
    assert.throws(() => interpretarResposta('não posso avaliar esse conteúdo'), ErroScorer);
  });

  test('a mensagem do erro identifica o campo problemático', () => {
    try {
      interpretarResposta(JSON.stringify({ ...valida, gancho: 42 }));
      assert.fail('deveria ter lançado');
    } catch (erro) {
      assert.ok(erro instanceof ErroScorer);
      assert.match(erro.message, /gancho/);
    }
  });

  test('sobrevive ao modelo devolvendo JSON cercado, que é o caso comum sem schema', () => {
    const saida = interpretarResposta('```json\n' + JSON.stringify(valida) + '\n```');
    assert.equal(saida.score, 8);
  });
});

describe('limpeza de artefato de JSON no texto', () => {
  const base = { score: 7, motivo: 'ok', resumo: 'ok', gancho: '' };
  const gancho = (g: string) => interpretarResposta(JSON.stringify({ ...base, gancho: g })).gancho;

  test('remove o `"}` que vazou em produção', () => {
    // Chegou assim no WhatsApp dela: o modelo pôs o artefato DENTRO da string,
    // então o JSON era válido e o parse não tinha como perceber.
    assert.equal(gancho('a coisa mais Ted Lasso que já aconteceu."}'), 'a coisa mais Ted Lasso que já aconteceu.');
  });

  test('remove chave e colchete soltos no fim', () => {
    assert.equal(gancho('acabou.}'), 'acabou.');
    assert.equal(gancho('acabou.]'), 'acabou.');
    assert.equal(gancho('acabou.\\"}'), 'acabou.');
  });

  test('preserva aspas legítimas no fim da frase', () => {
    // Sem chave junto, aspas são conteúdo: pode ser fala citada.
    assert.equal(gancho('e ela disse "acabou"'), 'e ela disse "acabou"');
  });

  test('não mexe em texto normal', () => {
    assert.equal(gancho('O Gus Fring entrou num filme de terror — e ninguém sabe do quê.'),
                 'O Gus Fring entrou num filme de terror — e ninguém sabe do quê.');
  });
});
