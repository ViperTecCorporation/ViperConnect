import { ViperConnectApp } from './app.js?v=4.0.41-39b50dec';
const root = document.getElementById('app');
if (!root)
    throw new Error('ViperConnect app root not found');
const app = new ViperConnectApp(root);
void app.start();
