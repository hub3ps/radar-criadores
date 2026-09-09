import '../testing/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { montarResumo } from './onboarding.js';
import type { Onboarding } from '../db/types.js';

const base: Onboarding = {
  id: 'x', whatsapp: '5511900000001', etapa: 'confirmacao',
  nicho: 'cinema e séries', perfil_texto: 'Lançamentos e elenco.',
  sites: [{ nome: 'Deadline', feed: 'https://deadline.com/feed/', site: 'https://deadline.com' }],
  instagram: ['variety'], tiktok: [],
  creator_id: null, atualizado_em: '', created_at: '',
};

describe('montarResumo', () => {
  test('mostra tudo que ela escolheu', () => {
    const r = montarResumo(base);
    assert.match(r, /cinema e séries/);
    assert.match(r, /Deadline/);
    assert.match(r, /@variety/);
  });

  test('categoria vazia aparece como (nenhum), não some', () => {
    // Sumir daria a impressão de que o cadastro perdeu a informação.
    assert.match(montarResumo(base), /\*TikTok\*: \(nenhum\)/);
  });

  test('pede confirmação explícita', () => {
    assert.match(montarResumo(base), /\*sim\*.*\*não\*/s);
  });

  test('cadastro sem nenhuma fonte ainda gera resumo utilizável', () => {
    const r = montarResumo({ ...base, sites: [], instagram: [], tiktok: [] });
    assert.match(r, /\(nenhum\)/);
    assert.match(r, /cinema e séries/);
  });
});
