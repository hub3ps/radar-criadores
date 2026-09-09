import './testing/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { expressaoCron } from './index.js';

describe('expressaoCron', () => {
  test('converte os intervalos padrão do projeto', () => {
    assert.equal(expressaoCron(5), '*/5 * * * *');   // RSS
    assert.equal(expressaoCron(60), '0 * * * *');    // social
    assert.equal(expressaoCron(2), '*/2 * * * *');   // dispatch
  });

  test('múltiplos de hora viram intervalo horário', () => {
    assert.equal(expressaoCron(120), '0 */2 * * *');
    assert.equal(expressaoCron(360), '0 */6 * * *');
  });

  test('recusa intervalo que não divide a hora, em vez de agendar errado', () => {
    assert.throws(() => expressaoCron(7), /não divide a hora/);
    assert.throws(() => expressaoCron(90), /não é múltiplo de 60/);
    assert.throws(() => expressaoCron(0), /intervalo inválido/);
  });
});
