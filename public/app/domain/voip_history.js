export const scopedHistoryItems = (state, phones) => {
    if (state.capabilities?.history !== true)
        return [];
    const owned = new Set(phones);
    return (state.history?.items || []).filter(record => typeof record.phoneNumber === 'string' && owned.has(record.phoneNumber));
};
export const scopedRecording = (state, phones, id) => {
    if (!id || state.capabilities?.recordings !== true)
        return undefined;
    const matches = scopedHistoryItems(state, phones).filter(record => `${record.id || record.callId || ''}` === id);
    return matches.length === 1 && matches[0].recordingStatus === 'available' ? matches[0] : undefined;
};
