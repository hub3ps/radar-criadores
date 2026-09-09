import '../testing/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { recemPublicado } from './process.js';
import type { Item } from '../db/types.js';

const horasAtras = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

const item = (campos: Partial<Item>): Item => ({
  id: 'i', source_id: 's', url: 'https://x/1', url_hash: 'h', titulo: 'T',
  texto: null, autor: null, publicado_em: null, coletado_em: horasAtras(0),
  entregavel: true, ...campos,
});

// ITEM_IDADE_MAX_HORAS padrão = 24
describe('recemPublicado', () => {
  test('publicado agora passa', () => {
    assert.equal(recemPublicado(item({ publicado_em: horasAtras(1) })), true);
  });

  test('publicado dentro do teto passa', () => {
    assert.equal(recemPublicado(item({ publicado_em: horasAtras(23) })), true);
  });

  test('publicado além do teto é barrado mesmo se coletado agora', () => {
    // É o caso da volta de uma queda: coleta nova, matéria velha.
    assert.equal(
      recemPublicado(item({ publicado_em: horasAtras(72), coletado_em: horasAtras(0) })),
      false,
    );
  });

  test('sem publicado_em, cai na data de coleta', () => {
    assert.equal(recemPublicado(item({ publicado_em: null, coletado_em: horasAtras(2) })), true);
    assert.equal(recemPublicado(item({ publicado_em: null, coletado_em: horasAtras(50) })), false);
  });

  test('data inválida não descarta o item', () => {
    // Feed com data quebrada é comum; perder a novidade por isso seria pior.
    assert.equal(recemPublicado(item({ publicado_em: 'ontem à tarde' })), true);
  });

  test('data no futuro passa — é relógio adiantado da fonte', () => {
    const futuro = new Date(Date.now() + 3_600_000).toISOString();
    assert.equal(recemPublicado(item({ publicado_em: futuro })), true);
  });
});
