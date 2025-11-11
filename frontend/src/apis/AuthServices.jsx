import axiosInstance from './AxiosConfig';

export const authService = {
    Login: async (credentials, additionalHeaders = {}) => {
        return axiosInstance.post('/auth/login', credentials, {
            headers: {
                ...additionalHeaders,
            },
        });
    },

    Logout: async (additionalHeaders = {}) => {
        return axiosInstance.get('/auth/logout', {
            headers: {
                ...additionalHeaders,
            },
        });
    },

    CheckToken: async (additionalHeaders = {}) => {
        return axiosInstance.get('/auth/check_token', {
            headers: {
                ...additionalHeaders,
            },
        });
    },

    FetchProfile: async (additionalHeaders = {}) => {
        return axiosInstance.get('/auth/profile', {
            headers: {
                ...additionalHeaders,
            },
        });
    },
};