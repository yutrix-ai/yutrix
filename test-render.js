require('@babel/register')({
  presets: [
    ['@babel/preset-env', { targets: { node: 'current' } }],
    ['@babel/preset-react', { runtime: 'automatic' }],
    '@babel/preset-typescript'
  ],
  extensions: ['.ts', '.tsx', '.js', '.jsx']
});
const React = require('react');
const ReactDOMServer = require('react-dom/server');

// Mock out hooks
const store = require('./apps/web/src/lib/store');
store.useAuth = () => ({ user: { role: 'user' } });

// Mock fetchApi to return some keys
jest = require('jest-mock');
const api = require('./apps/web/src/lib/api');
api.fetchApi = jest.fn().mockResolvedValue([
  { id: '1', name: 'k1', keyPrefix: 'pg_123', status: 'disabled', createdAt: new Date().toISOString() }
]);

const ApiKeys = require('./apps/web/src/pages/ApiKeys').default;

try {
  const html = ReactDOMServer.renderToString(React.createElement(ApiKeys));
  console.log("RENDER SUCCESS, length:", html.length);
} catch(e) {
  console.log("RENDER ERROR:", e);
}
