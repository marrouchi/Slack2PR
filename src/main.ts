import 'dotenv/config';
import { bootstrapHexabotApp } from '@hexabot-ai/api';
import { Agent, setGlobalDispatcher } from 'undici';

import { AppModule } from './app.module';

// The OpenCode harness (ai_coding_agent) drives its in-sandbox server through a
// blocking HTTP call that only responds once a whole agent turn completes, which
// routinely exceeds undici's default 300s headersTimeout and kills the run with
// UND_ERR_HEADERS_TIMEOUT ("fetch failed"). Disable the header/body timeouts
// process-wide; workflow-level timeouts and abort signals still bound the runs.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

async function bootstrap() {
  await bootstrapHexabotApp(AppModule, {
    listen: {
      port: Number.parseInt(`${process.env.PORT ?? ''}`, 10) || 3000,
    },
  });
}

bootstrap();
