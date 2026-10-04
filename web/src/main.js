import '@fontsource-variable/inter';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import { mount } from 'svelte';
import App from './App.svelte';
import { startFavicon } from './lib/favicon.js';
import './app.css';
import './components/hub-ui-library.css';
import './components/hub-ui-detail.css';
import './components/hub-ui-browse.css';
import './workspace.css';

startFavicon();

export default mount(App, { target: document.getElementById('app') });
