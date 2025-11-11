import { Outlet, Navigate } from 'react-router-dom';
import useAuthStore from '../stores/authStore';
import NavBar from '../components/NavBar';
import Footer from '../components/Footer';

const AdminRoutes = () => {
    const user = useAuthStore((state) => state.user)

    // Routes that Appear when user is (The Admin)
    return (
        user && user.role == 'Admin' ?
            <><NavBar /><Outlet /><Footer /></>
            : <Navigate to="/" replace />
    );
}

export default AdminRoutes;
