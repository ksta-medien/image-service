import app from './src/app';

const port = parseInt(process.env.PORT || '8080', 10);

console.log(`🚀 imgx-clone server starting on port ${port}...`);

export default {
  port,
  fetch: app.fetch,
};
