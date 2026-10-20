// Connects the page to your Firebase project. While `firebase` is null, everyone's prices are kept in
// their own browser only. These values only identify the project, so they're safe to publish:
// who can read and write is enforced by firestore.rules. See README.md for setup.
window.KINA_CONFIG = {
  firebase: null
  // firebase: {
  //   apiKey: 'paste from Firebase console',
  //   authDomain: 'your-project-id.firebaseapp.com',
  //   projectId: 'your-project-id',
  //   appId: 'paste from Firebase console'
  // }
};
