import { collectRss, collectSocial } from './jobs/collect.js';
import { dispatch } from './jobs/dispatch.js';
import { process as processarItens } from './jobs/process.js';
import { log } from './logger.js';

/** Roda um job avulso, fora do cron: `npm run job -- collect` */
const JOBS: Record<string, () => Promise<unknown>> = {
  collect: async () => {
    const rss = await collectRss();
    const social = await collectSocial();
    return { rss, social };
  },
  'collect:rss': collectRss,
  'collect:social': collectSocial,
  process: processarItens,
  dispatch,
};

const nome = process.argv[2];

if (!nome || !(nome in JOBS)) {
  console.error(`uso: npm run job -- <${Object.keys(JOBS).join('|')}>`);
  process.exit(1);
}

try {
  const resultado = await JOBS[nome]!();
  log.info('job avulso concluído', { job: nome, resultado });
  process.exit(0);
} catch (erro) {
  log.error('job avulso falhou', { job: nome, erro });
  process.exit(1);
}
