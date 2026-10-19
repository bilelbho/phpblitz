import ReactDOM from 'react-dom/client';
import './styles.css';
import App from './App';
import { installNativeFeel } from './nativeFeel';
import { installErrorLog } from './errorLog';

// First: errors while starting up are logged too.
installErrorLog();
installNativeFeel();

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
