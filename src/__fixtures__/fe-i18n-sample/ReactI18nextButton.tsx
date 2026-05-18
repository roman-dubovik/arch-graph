import { useTranslation } from 'react-i18next';

export const ReactI18nextButton = () => {
    const { t } = useTranslation();
    return <button>{t('common.cancel')}</button>;
};
