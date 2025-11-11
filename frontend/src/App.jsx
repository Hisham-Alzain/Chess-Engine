import { useEffect, useState, useRef } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import AnonymousRoutes from './routes/AnonymousRoutes.jsx';
import AdminRoutes from './routes/AdminRoutes.jsx';
import useAuthStore from './stores/authStore.jsx';
import Login from './components/Auth/Login.jsx';
import Logout from './components/Auth/Logout.jsx';
import Loading from './components/Loading.jsx';
import './App.css'


function App() {
  const initialized = useRef(false);
  const user = useAuthStore((state) => state.user)
  const loading = useAuthStore((state) => state.loading)
  const CheckToken = useAuthStore((state) => state.CheckToken)
  const FetchProfile = useAuthStore((state) => state.FetchProfile)

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      CheckToken().then((response) => {
        if (response) {
          FetchProfile();
        };
      });
    }
  }, []);

  if (loading) {
    return <Loading />;
  }
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/home" element={<></>} />
        <Route element={<AnonymousRoutes />}>
          <Route path="/" element={<Login />} />
        </Route>
        <Route element={<AdminRoutes />}>
          <Route path='/logout' element={<Logout />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App
