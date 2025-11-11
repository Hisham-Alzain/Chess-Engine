import Cookies from 'js-cookie';
import { create } from 'zustand';
import { authService } from '../apis/AuthServices';

const useAuthStore = create((set) => ({
    user: null,
    error: null,
    loading: true,

    Login: async (credentials, additionalHeaders = {}) => {
        set({ loading: true, error: null });
        try {
            const { user, token } = await authService.Login(credentials, additionalHeaders);
            Cookies.set('access_token', btoa(token), { secure: true, expires: null });
            set({ user, loading: false });
        } catch (error) {
            set({ error, loading: false });
            throw error;
        }
    },

    Logout: async (additionalHeaders = {}) => {
        set({ loading: true });
        try {
            await authService.Logout(additionalHeaders);
            Cookies.remove('access_token');

            set({ user: null, loading: false });
        } catch (error) {
            set({ error: error, loading: false });
            throw error;
        }
    },

    CheckToken: async (additionalHeaders = {}) => {
        try {
            const token = Cookies.get('access_token');
            if (token) {
                await authService.CheckToken(additionalHeaders);
                return true
            } else {
                set({ loading: false });
                return false
            }
        } catch (error) {
            set({ user: null, loading: false });
            throw error;
        }
    },

    FetchProfile: async (additionalHeaders = {}) => {
        set({ loading: true });
        try {
            const { user } = await authService.FetchProfile(additionalHeaders);
            set({ user, loading: false });
        } catch (error) {
            set({ error, loading: false });
            throw error;
        }
    },
}));

export default useAuthStore;