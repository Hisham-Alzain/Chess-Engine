import { useState, useEffect } from "react";
import { useTranslation } from 'react-i18next';
import {
  FaFacebookF, FaInstagram, FaWhatsapp, FaTelegramPlane
} from 'react-icons/fa';
import styles from '../styles/footer.module.css'

const Footer = () => {
  // Translations
  const { t } = useTranslation('global');
  // State
  const [year, setYear] = useState(new Date().getFullYear());

  useEffect(() => {
    setYear(new Date().getFullYear());
  }, []);

  return (
    <footer>
      <div className={styles.footer}>
        <div className={styles.top}>
          <div className={styles.row}>
            <div className={styles.social}>
              <a href="#"><FaFacebookF /></a>
              <a href="#"><FaInstagram /></a>
              <a href="#"><FaWhatsapp /></a>
              <a href="#"><FaTelegramPlane /></a>
            </div>
          </div>
        </div>
        <div className={styles.bottom}>
          <div className={styles.row}>
            <div className={styles.copy_right}>
              {`${t('components.footer.part1')}${year} 
              ${t('components.footer.part2')}`}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}

export default Footer;
