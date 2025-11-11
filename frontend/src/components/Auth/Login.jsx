import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useAuthStore from '../../stores/authStore';
import styles from '../../styles/login.module.css';
// import banner from '../assets/hero.png';

const Login = () => {
  const Login = useAuthStore((state) => state.Login)
  // Translations
  const { t } = useTranslation('global');
  // States
  const [userName, setUserName] = useState('');
  const [password, setPassword] = useState('');

  // Handle form submit
  const handleSubmit = (event) => {
    event.preventDefault();

    var credentials = {
      user_name: userName,
      password: password,
    }
    // Perform Login logic (Call api)
    Login(credentials);
  }

  return (
    <div className={styles.page}>
      {/* <div className={styles.banner}>
        <img src={banner} alt="Banner" />
      </div> */}
      <div className={styles.row}>
        <div className={styles.column}>
          <div className={styles.left_content}>
            <h1>{t('components.login.h1')}</h1>
          </div>
        </div>
        <div className={styles.column}>
          <div className={styles.right_content}>
            <form onSubmit={handleSubmit} className={styles.login_form}>
              <h1>{t('components.login.login')}</h1>
              <div className={styles.input_field}>
                <input
                  required
                  type="text"
                  placeholder={t('components.login.i1')}
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                />
              </div>
              <div className={styles.input_field}>
                <input
                  required
                  type="password"
                  placeholder={t('components.login.i2')}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {/* <p>{message}</p> */}

              {/* <div>
                <input
                  id="rememberMe"
                  type="checkbox"
                  onChange={(event) => setRememberMe(event.target.checked)}
                />
                <label htmlFor="rememberMe">{t('components.login.remember_me')}</label>
              </div> */}
              <div className={styles.button_container}>
                <button className={styles.login_button}>
                  {t('components.login.login')}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Login;
