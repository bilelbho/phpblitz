import ReactDOM from 'react-dom/client';
import './monaco';
import './mago';
import './styles.css';
import App from './App';
import { installNativeFeel } from './nativeFeel';

installNativeFeel();

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
