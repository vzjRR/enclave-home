fx_version 'cerulean'
game 'gta5'

author 'Enclave RP'
description 'Publishes anonymous player positions (x,y only) for the enclaverp.cc mini-map. No names, no ids.'
version '1.0.0'

server_script 'server.lua'

-- Declaring the file here is what makes FXServer's existing static
-- resource file server answer http://<address>/enclave-positions/positions.json
-- with whatever server.lua last wrote there. No SetHttpHandler, so this
-- cannot conflict with any other resource's HTTP handling.
files {
    'positions.json'
}
