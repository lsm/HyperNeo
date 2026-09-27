import '../styles.css';
import '../lib/theme.ts';
import { render } from 'preact';
import { NeoLive } from './NeoLive.tsx';
import { NeoExamples } from './NeoExamples.tsx';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
render(new URLSearchParams(location.search).has('examples') ? <NeoExamples /> : <NeoLive />, root);
