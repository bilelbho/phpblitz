import ReactDOM from 'react-dom/client';
import './styles.css';
import App from './App';
import { installNativeFeel } from './nativeFeel';

installNativeFeel();

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
