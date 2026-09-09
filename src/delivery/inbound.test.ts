import '../testing/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extrairMensagem, lerFeedback, tokenValido } from './inbound.js';

/** Payload como a Evolution v2 manda uma mensagem simples. */
const simples = (texto: string, fromMe = false) => ({
  event: 'messages.upsert',
  instance: 'radar',
  data: {
    key: { remoteJid: '5511999998888@s.whatsapp.net', fromMe, id: 'ABC123' },
    message: { conversation: texto },
    pushName: 'Fulana',
  },
});

/** Payload de uma resposta: o texto muda de lugar e ganha o stanzaId. */
const resposta = (texto: string, stanzaId: string) => ({
  event: 'messages.upsert',
  data: {
    key: { remoteJid: '5511999998888@s.whatsapp.net', fromMe: false, id: 'DEF456' },
    message: {
      extendedTextMessage: {
        text: texto,
        contextInfo: { stanzaId, participant: '5511999998888@s.whatsapp.net' },
      },
    },
  },
});

describe('lerFeedback', () => {
  test('reconhece 1, 2 e 3', () => {
    assert.equal(lerFeedback('1'), 1);
    assert.equal(lerFeedback(' 2 '), 2);
    assert.equal(lerFeedback('3.'), 3);
  });

  test('ignora qualquer outra coisa', () => {
    for (const texto of ['0', '4', 'oi', '', '1 gostei', '11']) {
      assert.equal(lerFeedback(texto), null, `deveria ignorar "${texto}"`);
    }
  });
});

describe('extrairMensagem', () => {
  test('lê mensagem simples', () => {
    const msg = extrairMensagem(simples('1'));
    assert.equal(msg?.texto, '1');
    assert.equal(msg?.de, '5511999998888');
    assert.equal(msg?.minha, false);
    assert.equal(msg?.respondendoA, null);
  });

  test('lê resposta e captura o id da mensagem respondida', () => {
    const msg = extrairMensagem(resposta('2', 'MSG_ORIGINAL'));
    assert.equal(msg?.texto, '2');
    assert.equal(msg?.respondendoA, 'MSG_ORIGINAL');
  });

  test('marca o eco das mensagens que nós mesmos mandamos', () => {
    assert.equal(extrairMensagem(simples('1', true))?.minha, true);
  });

  test('aceita `data` como lista, que é como alguns modos entregam', () => {
    const payload = { ...simples('3'), data: [simples('3').data] };
    assert.equal(extrairMensagem(payload)?.texto, '3');
  });

  test('tira o sufixo de dispositivo do jid', () => {
    const payload = simples('1');
    payload.data.key.remoteJid = '5511999998888:12@s.whatsapp.net';
    assert.equal(extrairMensagem(payload)?.de, '5511999998888');
  });

  test('devolve null para o que não é mensagem de texto', () => {
    assert.equal(extrairMensagem(null), null);
    assert.equal(extrairMensagem({ event: 'connection.update', data: {} }), null);
    assert.equal(extrairMensagem({ event: 'messages.upsert', data: { key: {} } }), null);
    assert.equal(
      extrairMensagem({
        event: 'messages.upsert',
        data: { key: { remoteJid: 'x@s.whatsapp.net' }, message: { imageMessage: {} } },
      }),
      null,
    );
  });
});

describe('tokenValido', () => {
  test('aceita o token configurado e recusa o resto', () => {
    assert.equal(tokenValido('token-de-teste-longo'), true);
    assert.equal(tokenValido('token-de-teste-erra'), false);
    assert.equal(tokenValido('curto'), false);
    assert.equal(tokenValido(undefined), false);
    assert.equal(tokenValido(''), false);
  });
});
