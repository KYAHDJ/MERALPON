import { initializeApp } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyBFZHL1rVmUl73mgL1KviHC8tIkf9V21rw",
  authDomain: "meralpon-91265.firebaseapp.com",
  projectId: "meralpon-91265",
  storageBucket: "meralpon-91265.firebasestorage.app",
  messagingSenderId: "394472710880",
  appId: "1:394472710880:web:97dba6fed3eacea2186685",
  measurementId: "G-FPDRYKKZXQ",
};

const firebaseApp = initializeApp(firebaseConfig);

export const auth = getAuth(firebaseApp);
export const db = getFirestore(firebaseApp);
