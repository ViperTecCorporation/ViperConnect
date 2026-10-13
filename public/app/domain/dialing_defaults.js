export const inferBrazilianDialingDefaults = (number) => {
    const digits = `${number || ''}`.replace(/\D/g, '');
    const ddd = digits.slice(2, 4);
    return /^55\d{10,11}$/.test(digits) && /^(?:1[1-9]|2[12478]|3[1-578]|4[1-9]|5[1345]|6[1-9]|7[134579]|8[1-9]|9[1-9])$/.test(ddd)
        ? { defaultDdi: '55', defaultDdd: ddd }
        : { defaultDdi: '', defaultDdd: '' };
};
