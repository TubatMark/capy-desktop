import {openStore} from '../../server/db/index';
const store=openStore(process.argv[2]!);
try{store.save('projects','shared',{writer:process.pid},4);console.log('saved');}catch(error){if(String(error).includes('revision conflict'))console.log('conflict');else throw error;}finally{store.close();}
