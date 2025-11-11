import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import useAuthStore from '../stores/authStore';
import { FaBars, FaTimes, FaDoorOpen } from "react-icons/fa";
import styles from '../styles/navbar.module.css';


const NavBar = () => {
  const user = useAuthStore((state) => state.user)
  // Translations
  const { t, i18n } = useTranslation('global');

  useEffect(() => {
    localStorage.setItem('Lang', i18n.language);
    document.documentElement.lang = i18n.language;
    document.documentElement.dir = i18n.dir(i18n.language);
  }, [i18n.language]);

  const changeLanguage = (event) => {
    if (event.target.value === 'en' || event.target.value === 'ar') {
      i18n.changeLanguage(event.target.value);
    }
  };

  const langs = [
    { key: "en", value: "en", O: "English" },
    { key: "ar", value: "ar", O: "العربية" }
  ];

  return (
    <nav>
      <div className={styles.wrapper}>
        <input
          type="radio"
          name="slider"
          id="menu_btn"
          className={styles.menu_btn}
        />
        <input
          type="radio"
          name="slider"
          id="close_btn"
          className={styles.close_btn}
        />

        <ul className={styles.nav_links}>
          <div className={styles.nav_links_left}>
            {user && <>
              <li>
                <a href="/home">home</a>
              </li>
            </>}
          </div>
          <div className={styles.nav_links_right}>
            <label
              htmlFor="close_btn"
              className={`${styles.btn} ${styles.close_btn}`}
            >
              <FaTimes size={31} />
            </label>
            <div className={styles.lang}>
              <select onChange={changeLanguage} value={i18n.language}>
                {langs.map((lang) => (
                  <option key={lang.key} value={lang.value}>
                    {lang.O}
                  </option>
                ))}
              </select>
            </div>
            {user ? (
              <li id='Logout'>
                <a href="/logout" title='logout'>
                  <span className={styles.logout_span}>
                    <span><FaDoorOpen size={23} /></span>
                    <label htmlFor='Logout' className={styles.mobile_item}>
                      logout
                    </label>
                  </span>
                </a>
              </li>
            ) : (
              <li>
                <a href="/login">login</a>
              </li>
            )}
          </div>
        </ul>
        <label
          htmlFor="menu_btn"
          className={`${styles.btn} ${styles.menu_btn}`}
        >
          <FaBars size={29} />
        </label>
      </div>
    </nav>
  );
};

export default NavBar;
