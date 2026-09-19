import '../testing/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { decidir, ehApanhado, escolhido, montarLista, republicada, type Recebido } from './repetidas.js';

const recebidos: Recebido[] = [
  {
    id: 'd1',
    titulo: "Nicole Wallace Joins Josh Heuston In Amazon MGM Romance 'Throttled'",
    resumo: 'A Amazon MGM fechou a protagonista de Throttled.',
    nomeFonte: 'Deadline',
  },
  { id: 'd2', titulo: 'A Garota do Remo – Crítica', resumo: null, nomeFonte: 'Observatório do Cinema' },
];

describe('montarLista', () => {
  test('numera a partir de 1, com fonte e resumo', () => {
    const lista = montarLista(recebidos);
    assert.match(lista, /^1\. \[Deadline\] Nicole Wallace/);
    assert.match(lista, /\n {3}A Amazon MGM fechou/);
    assert.match(lista, /\n2\. \[Observatório do Cinema\] A Garota do Remo/);
  });

  test('item sem resumo fica só com o cabeçalho', () => {
    const lista = montarLista([recebidos[1]!]);
    assert.equal(lista, '1. [Observatório do Cinema] A Garota do Remo – Crítica');
  });
});

describe('escolhido', () => {
  test('número válido aponta o delivery da lista', () => {
    assert.equal(escolhido(1, recebidos)?.id, 'd1');
    assert.equal(escolhido(2, recebidos)?.id, 'd2');
  });

  test('0 é "não repete"', () => {
    assert.equal(escolhido(0, recebidos), null);
  });

  test('número fora da lista deixa o item passar', () => {
    // Resposta inventada pelo modelo não pode barrar novidade.
    assert.equal(escolhido(3, recebidos), null);
    assert.equal(escolhido(-1, recebidos), null);
    assert.equal(escolhido(Number.NaN, recebidos), null);
  });

  test('lista vazia nunca repete', () => {
    assert.equal(escolhido(1, []), null);
  });
});

describe('decidir', () => {
  const resposta = {
    manchete_nova: 'Nicole Wallace e Josh Heuston estrelam Puro Impulso',
    tipo_novo: 'anuncio' as const,
    numero: 1,
    tipo_da_lista: 'anuncio' as const,
    mesma_manchete: true,
  };

  test('anúncio que repete anúncio é barrado', () => {
    assert.equal(decidir(resposta, recebidos)?.id, 'd1');
  });

  test('crítica, apanhado ou reação nunca repetem, mesmo com mesma_manchete', () => {
    // O modelo dizia "mesma manchete" para "Minka Kelly reage ao cancelamento"
    // contra o próprio cancelamento. A regra não pode depender dele.
    assert.equal(decidir({ ...resposta, tipo_novo: 'outro' }, recebidos), null);
    assert.equal(decidir({ ...resposta, tipo_da_lista: 'outro' }, recebidos), null);
  });

  test('anúncios diferentes passam', () => {
    assert.equal(decidir({ ...resposta, mesma_manchete: false }, recebidos), null);
  });
});

describe('ehApanhado', () => {
  test('reconhece os apanhados do histórico real', () => {
    assert.equal(ehApanhado('Everything We Know About Netflix’s New ‘Pride & Prejudice’ Series So Far'), true);
    assert.equal(ehApanhado('What To Expect For ‘Heated Rivalry’ Season 2: Everything We Know So Far'), true);
    assert.equal(ehApanhado('Tudo o que já sabemos sobre a 2ª temporada'), true);
  });

  test('anúncio que só menciona "sabemos" no meio não é apanhado', () => {
    assert.equal(ehApanhado('Já sabemos quando estreia a 3ª temporada de Ninguém Quer na Netflix'), false);
    assert.equal(ehApanhado('Nicole Wallace Joins Josh Heuston In Amazon MGM Romance ‘Throttled’'), false);
  });
});

describe('republicada', () => {
  test('mesmo site e mesmo título é a mesma matéria, sem depender de aspas', () => {
    const lista: Recebido[] = [
      { id: 'd9', titulo: 'Após desastre, ‘Supergirl’ chega ao streaming', resumo: null, nomeFonte: 'CinePOP' },
    ];
    const novo = { titulo: "Após desastre, 'Supergirl' chega ao streaming!", resumo: null, nomeFonte: 'CinePOP' };
    assert.equal(republicada(novo, lista)?.id, 'd9');
  });

  test('mesmo título em outro site não é republicação', () => {
    // Pode ser a mesma notícia, mas isso é o modelo quem decide.
    const lista: Recebido[] = [{ id: 'd9', titulo: 'Verity', resumo: null, nomeFonte: 'CinePOP' }];
    assert.equal(republicada({ titulo: 'Verity', resumo: null, nomeFonte: 'Capricho' }, lista), null);
  });
});
