
import { createRoot } from 'react-dom/client'
import React from 'react'
import {Provider} from 'react-redux'
import {GoogleOAuthProvider} from '@react-oauth/google'
import axios from 'axios'
import './index.css'
import App from './App.jsx'
import store from './store.js'


const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID

axios.interceptors.request.use(
  (response)=>response,
  (error)=>{
    if(error.response && error.response.status === 401){
      localStorage.removeItem('user');
      window.location.href='/login';
    }
    return Promise.reject(error);
  }
);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <Provider store={store}>
        <Router>
          <App/>
        </Router>
      </Provider>
    </GoogleOAuthProvider>
  </StrictMode>,
)
