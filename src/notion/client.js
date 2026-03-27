import { Client as NotionClient } from '@notionhq/client';
import config from '../config.js';

const notion = new NotionClient({
  auth: config.notion.apiKey,
  timeoutMs: 15000,
});

export default notion;
