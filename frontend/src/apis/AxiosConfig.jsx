import axios from 'axios';
import Cookies from 'js-cookie';

const axiosInstance = axios.create({
    baseURL: "http://127.0.0.1:8000",
    headers: {
        'Accept': 'application/json',
    },
});

// Request interceptor
axiosInstance.interceptors.request.use(
    (config) => {
        // You can modify the request config here (e.g., add auth token)
        const encodedToken = Cookies.get('access_token');
        if (encodedToken) {
            const token = atob(encodedToken); // decode
            config.headers.Authorization = `Bearer ${token}`;
        }
        return config;
    },
    (error) => {
        return Promise.reject(error);
    }
);

// Response interceptor
axiosInstance.interceptors.response.use(
    (response) => response.data,
    (error) => {
        // Handle errors globally
        if (error.response?.status === 401) {
            // Handle unauthorized access
            Cookies.remove('access_token');
        }
        return Promise.reject(error.response?.data || error.message);
    }
);

export default axiosInstance;