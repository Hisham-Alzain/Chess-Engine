import { Outlet, Navigate } from 'react-router-dom';
import useAuthStore from '../stores/authStore';

const AnonymousRoutes = () => {
  const user = useAuthStore((state) => state.user)

  // Routes that Appear when user is not LoggedIn
  return (
    user ? <Navigate to="/home" replace /> : <Outlet />
  );
}

export default AnonymousRoutes;
