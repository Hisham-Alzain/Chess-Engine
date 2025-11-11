import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import useAuthStore from '../../stores/authStore';

const Logout = () => {
  const Logout = useAuthStore((state) => state.Logout)
  const initialized = useRef(false);
  const navigate = useNavigate()

  useEffect(() => {
    if (!initialized.current) {
      initialized.current = true;
      Logout();

      navigate('/');
    }
  }, []);

  return <></>;
};

export default Logout;
