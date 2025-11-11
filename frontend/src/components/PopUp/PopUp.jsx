import Popup from 'reactjs-popup';
import 'reactjs-popup/dist/index.css';
import { useTranslation } from 'react-i18next';
import { FaCircleInfo } from "react-icons/fa6";
import styles from '../../styles/PopUps/popup.module.css';


const PopUp = () => {
  // Translations
  const { t, i18n } = useTranslation('global');

  return (
    <Popup
      trigger={
        <button className={styles.info_button}
          title={` the title`}>
          <FaCircleInfo />
        </button>
      }
      modal
      nested
    >
      {close => (
        <div className={styles.modal}>
          <button className={styles.close} onClick={close}>
            &times;
          </button>
          <div className={styles.header}>
            {``}
          </div>
          <div className={styles.content}>
            <table className={styles.table}>
              <tbody>
                <tr>
                  <th>"here we put the info"</th>
                  <td>
                  "here we put the data"
                  </td>
                </tr>
                <tr>
                  <th>"here we put the info"</th>
                  <td>
                  "here we put the data"
                  </td>
                </tr>
                <tr>
                  <th>"here we put the info"</th>
                  <td>
                  "here we put the data"
                  </td>
                </tr>
                <tr>
                  <th>"here we put the info"</th>
                  <td>
                  "here we put the data"
                  </td>
                </tr>
                <tr>
                  <th>"here we put the info"</th>
                  <td>
                  "here we put the data"
                  </td>
                </tr>
                <tr>
                  <th>"here we put the info"</th>
                  <td>
                  "here we put the data"
                  </td>
                </tr>
                <tr>
                  <th>"here we put the info"</th>
                  <td>
                  "here we put the data"
                  </td>
                </tr>
                <tr>
                  <th>"here we put the info"</th>
                  <td>
                  "here we put the data"
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div className={styles.actions}></div>
        </div>
      )}
    </Popup>
  )
};

export default PopUp;
