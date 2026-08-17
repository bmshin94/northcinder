import { defineConfig } from 'astro/config';
import { SITE_URL } from './src/public-coordinates.ts';

export default defineConfig({
  output: 'static',
  ...(SITE_URL ? { site: SITE_URL } : {}),
  compressHTML: true,
});
