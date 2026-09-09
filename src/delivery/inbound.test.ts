import '../testing/env.js';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extrairMensagem, idDaCitacao, lerFeedback, tokenValido } from './inbound.js';

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

describe('extrairMensagem — formatos que a Evolution manda de verdade', () => {
  const comEvento = (evento: string) => ({
    event: evento,
    data: {
      key: { remoteJid: '5547996489767@s.whatsapp.net', fromMe: false, id: 'A' },
      message: { conversation: '1' },
    },
  });

  test('aceita MESSAGES_UPSERT em maiúscula com underscore', () => {
    // Foi exatamente isto que fez o primeiro feedback real sumir em produção.
    assert.equal(extrairMensagem(comEvento('MESSAGES_UPSERT'))?.texto, '1');
  });

  test('aceita messages.upsert em minúscula com ponto', () => {
    assert.equal(extrairMensagem(comEvento('messages.upsert'))?.texto, '1');
  });

  test('aceita variações de caixa', () => {
    assert.equal(extrairMensagem(comEvento('Messages.Upsert'))?.texto, '1');
  });

  test('continua recusando outros eventos', () => {
    assert.equal(extrairMensagem(comEvento('CONNECTION_UPDATE')), null);
    assert.equal(extrairMensagem(comEvento('contacts.update')), null);
  });
});

describe('extrairMensagem — id da mensagem de entrada', () => {
  test('captura key.id, que é a chave de idempotência', () => {
    assert.equal(extrairMensagem(simples('1'))?.id, 'ABC123');
    assert.equal(extrairMensagem(resposta('2', 'ORIG'))?.id, 'DEF456');
  });

  test('payload sem key.id não quebra — vira null', () => {
    const p = simples('1');
    delete (p.data.key as Record<string, unknown>).id;
    const msg = extrairMensagem(p);
    assert.equal(msg?.id, null);
    assert.equal(msg?.texto, '1');
  });
});

describe('idDaCitacao — onde a Evolution esconde o id da mensagem citada', () => {
  const alvo = 'MSG_CITADA';

  test('dentro de message.extendedTextMessage.contextInfo', () => {
    assert.equal(
      idDaCitacao({ message: { extendedTextMessage: { text: '1', contextInfo: { stanzaId: alvo } } } }),
      alvo,
    );
  });

  test('içado para data.contextInfo — a forma que quebrou em produção', () => {
    assert.equal(
      idDaCitacao({ message: { extendedTextMessage: { text: '1' } }, contextInfo: { stanzaId: alvo } }),
      alvo,
    );
  });

  test('dentro de message.contextInfo', () => {
    assert.equal(idDaCitacao({ message: { contextInfo: { stanzaId: alvo } } }), alvo);
  });

  test('sob o nome alternativo quotedMessageId', () => {
    assert.equal(idDaCitacao({ contextInfo: { quotedMessageId: alvo } }), alvo);
  });

  test('mensagem sem citação devolve null', () => {
    assert.equal(idDaCitacao({ message: { conversation: '1' } }), null);
    assert.equal(idDaCitacao({}), null);
  });

  test('extrairMensagem enxerga a citação içada', () => {
    const msg = extrairMensagem({
      event: 'MESSAGES_UPSERT',
      data: {
        key: { remoteJid: '5547996489767@s.whatsapp.net', fromMe: false, id: 'R1' },
        message: { extendedTextMessage: { text: '1' } },
        contextInfo: { stanzaId: alvo },
      },
    });
    assert.equal(msg?.texto, '1');
    assert.equal(msg?.respondendoA, alvo);
  });
});
